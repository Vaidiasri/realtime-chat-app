import express from 'express';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentName,
  attachmentParam,
  conversationIdParam,
  type AttachmentResponse,
} from '@chat/shared';
import { AppError } from '../../errors.js';
import { parse, userOf } from '../../http.js';
import * as attachments from './service.js';

export function attachmentsRouter(): express.Router {
  const router = express.Router();

  // The file is the raw request body; its name rides in the query string.
  router.post(
    '/:id/attachments',
    express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES }),
    async (req, res) => {
      const { id } = parse(conversationIdParam, req.params, new AppError('not_found', 404));
      const { name } = parse(attachmentName, req.query);
      const body: unknown = req.body;
      const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      const attachment = await attachments.upload(
        userOf(req).id,
        id,
        name,
        req.get('content-type') ?? '',
        data,
      );
      res.status(201).json({ attachment } satisfies AttachmentResponse);
    },
  );

  router.get('/:id/attachments/:attachmentId', async (req, res) => {
    const { id, attachmentId } = parse(attachmentParam, req.params, new AppError('not_found', 404));
    const file = await attachments.download(userOf(req).id, id, attachmentId);
    // Images render inline; anything else downloads. nosniff (helmet) stops the browser guessing.
    const disposition = file.mime.startsWith('image/') ? 'inline' : 'attachment';
    res
      .type(file.mime)
      .set({
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      .send(file.data);
  });

  return router;
}
