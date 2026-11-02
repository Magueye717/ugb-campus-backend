import { ObjectId, type Collection, type Db } from 'mongodb';

import type { Config } from '../../config/env.js';
import type { SessionDenylist } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { randomToken, sha256 } from '../../platform/security/crypto.js';
import type { TokenService } from '../../platform/security/tokens.js';
import type { AuditApi } from '../audit/index.js';
import type { DeviceInfo, SessionDoc, Tokens } from './identity.types.js';

const DAY = 24 * 3600_000;

/** Refresh tokens: opaque, stored hashed, rotated on every use, reuse revokes the whole family. */
export class SessionService {
  private readonly col: Collection<SessionDoc>;

  constructor(
    db: Db,
    private readonly config: Pick<Config, 'REFRESH_TOKEN_TTL_DAYS' | 'REFRESH_TOKEN_ABSOLUTE_DAYS'>,
    private readonly clock: Clock,
    private readonly tokens: TokenService,
    private readonly denylist: SessionDenylist,
    private readonly audit: AuditApi,
  ) {
    this.col = db.collection<SessionDoc>('sessions');
  }

  /** A new login: new family. */
  async start(user: { _id: ObjectId; platformRoles: string[] }, device: DeviceInfo, ip: string): Promise<Tokens> {
    const now = this.clock.now();
    return this.issue(user, { familyId: new ObjectId(), familyStartedAt: now }, device, ip);
  }

  async refresh(refreshToken: string, ip: string, loadUser: (id: ObjectId) => Promise<{ _id: ObjectId; platformRoles: string[]; status: string } | null>): Promise<Tokens> {
    const now = this.clock.now();
    const tokenHash = sha256(refreshToken);
    const current = await this.col.findOneAndUpdate(
      { tokenHash, status: 'active', expiresAt: { $gt: now } },
      { $set: { status: 'rotated', lastUsedAt: now } },
      { returnDocument: 'before' },
    );
    if (!current) {
      const known = await this.col.findOne({ tokenHash });
      if (known?.status === 'rotated') {
        // A token that was already exchanged is being replayed: assume theft, end every session of this login.
        await this.revokeFamily(known.familyId);
        await this.audit.record({ actor: { type: 'system' }, action: 'session.reuse_detected', target: { type: 'user', id: known.userId.toHexString() }, ip });
      }
      throw errors.unauthenticated('Ta session a expiré. Reconnecte-toi.');
    }
    const user = await loadUser(current.userId);
    if (!user || user.status !== 'active') {
      await this.revokeFamily(current.familyId);
      throw errors.unauthenticated('Ta session a expiré. Reconnecte-toi.');
    }
    const tokens = await this.issue(user, current, current.device, ip);
    return tokens;
  }

  async logout(refreshToken: string, userId: string) {
    const s = await this.col.findOneAndUpdate(
      { tokenHash: sha256(refreshToken), userId: new ObjectId(userId), status: 'active' },
      { $set: { status: 'revoked' } },
    );
    if (s) await this.denylist.revoke([s._id.toHexString()]);
  }

  /** Every session of the user, optionally keeping the current one (password change). */
  async revokeAll(userId: ObjectId, keepSessionId?: string) {
    const filter = { userId, status: { $in: ['active', 'rotated'] as SessionDoc['status'][] }, ...(keepSessionId ? { _id: { $ne: new ObjectId(keepSessionId) } } : {}) };
    const ids = await this.col.find(filter, { projection: { _id: 1 } }).map((s) => s._id).toArray();
    if (!ids.length) return;
    await this.col.updateMany({ _id: { $in: ids } }, { $set: { status: 'revoked' } });
    await this.denylist.revoke(ids.map((id) => id.toHexString()));
  }

  private async revokeFamily(familyId: ObjectId) {
    const ids = await this.col.find({ familyId }, { projection: { _id: 1 } }).map((s) => s._id).toArray();
    await this.col.updateMany({ familyId }, { $set: { status: 'revoked' } });
    await this.denylist.revoke(ids.map((id) => id.toHexString()));
  }

  private async issue(
    user: { _id: ObjectId; platformRoles: string[] },
    family: { familyId: ObjectId; familyStartedAt: Date; _id?: ObjectId },
    device: DeviceInfo | SessionDoc['device'],
    ip: string,
  ): Promise<Tokens> {
    const now = this.clock.now();
    const refreshToken = randomToken();
    // Sliding 30 days, never beyond 90 days after the login.
    const expiresAt = new Date(Math.min(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY, family.familyStartedAt.getTime() + this.config.REFRESH_TOKEN_ABSOLUTE_DAYS * DAY));
    const doc: SessionDoc = {
      _id: new ObjectId(),
      userId: user._id,
      familyId: family.familyId,
      familyStartedAt: family.familyStartedAt,
      tokenHash: sha256(refreshToken),
      status: 'active',
      replacedBy: null,
      device: { id: device.id ?? null, platform: device.platform ?? null, appVersion: device.appVersion ?? null },
      ip,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
    };
    await this.col.insertOne(doc);
    if (family._id) await this.col.updateOne({ _id: family._id }, { $set: { replacedBy: doc._id } });
    const access = await this.tokens.signAccess({ sub: user._id.toHexString(), sid: doc._id.toHexString(), roles: user.platformRoles });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
  }
}
