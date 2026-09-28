import { ATTACHMENT_MAX_BYTES, type Attachment, type AttachmentType } from '@chat/shared';
import { AppError } from '../../errors.js';
import { assertMember } from '../conversations/service.js';
import * as q from './queries.js';

const starts = (buf: Buffer, sig: string, at = 0) =>
  buf.subarray(at, at + sig.length).equals(Buffer.from(sig, 'latin1'));

/**
 * The type comes from the file's leading bytes, not the client's label, so a script renamed to
 * .png is refused. Text has no signature: it is accepted when labelled text and free of NUL bytes.
 */
export function sniff(buf: Buffer, declared: string): AttachmentType | null {
  if (starts(buf, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (starts(buf, '\xff\xd8\xff')) return 'image/jpeg';
  if (starts(buf, 'GIF87a') || starts(buf, 'GIF89a')) return 'image/gif';
  if (starts(buf, 'RIFF') && starts(buf, 'WEBP', 8)) return 'image/webp';
  if (starts(buf, '%PDF-')) return 'application/pdf';
  if (declared.split(';')[0]?.trim() === 'text/plain' && !buf.includes(0)) return 'text/plain';
  return null;
}

// Path separators and control characters never reach a Content-Disposition header.
// eslint-disable-next-line no-control-regex
const cleanName = (name: string) => name.replace(/[\x00-\x1f\x7f/\\]/g, '_');

export async function upload(
  userId: string,
  conversationId: string,
  name: string,
  declared: string,
  data: Buffer,
): Promise<Attachment> {
  await assertMember(userId, conversationId);
  if (data.length === 0 || data.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError('invalid_input', 400);
  }
  const mime = sniff(data, declared);
  if (!mime) throw new AppError('unsupported_type', 415);
  const row = await q.insertAttachment({
    conversation_id: conversationId,
    uploader_id: userId,
    name: cleanName(name),
    mime,
    data,
  });
  return { id: row.id, name: row.name, mime, size: row.size };
}

/** Members only. A file not yet sent is visible to its uploader alone. */
export async function download(userId: string, conversationId: string, attachmentId: string) {
  await assertMember(userId, conversationId);
  const file = await q.findAttachment(attachmentId, conversationId);
  if (!file || (file.message_id === null && file.uploader_id !== userId)) {
    throw new AppError('not_found', 404);
  }
  return { name: file.name, mime: file.mime as AttachmentType, data: file.data };
}
