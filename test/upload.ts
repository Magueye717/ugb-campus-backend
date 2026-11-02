import sharp from 'sharp';

/** A real picture for upload tests (a solid colour, PNG unless said otherwise). */
export const picture = (width = 1200, height = 800, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: '#2a6' } })[format]().toBuffer();

/** A multipart/form-data body with one file field, as the app sends it. */
export function multipart(file: Buffer, filename = 'photo.png', contentType = 'image/png') {
  const boundary = `----ugb${Date.now().toString(16)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
