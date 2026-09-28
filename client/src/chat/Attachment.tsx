import { useQuery } from '@tanstack/react-query';
import type { Attachment } from '@chat/shared';
import { authedFetch } from '../api';

// The download needs the Bearer token, so an <img src> cannot fetch it: fetch once, show a blob URL.
// ponytail: blob URLs live until the tab closes; revoke on unmount if long sessions grow heavy.
const blobUrl = async (conversationId: string, id: string) =>
  URL.createObjectURL(
    await (await authedFetch(`/api/conversations/${conversationId}/attachments/${id}`)).blob(),
  );

const sizeText = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

export function AttachmentView({
  conversationId,
  file,
}: {
  conversationId: string;
  file: Attachment;
}) {
  const isImage = file.mime.startsWith('image/');
  const url = useQuery({
    queryKey: ['attachment', file.id],
    queryFn: () => blobUrl(conversationId, file.id),
    enabled: isImage,
    staleTime: Infinity,
  });
  const download = async () => {
    const href = url.data ?? (await blobUrl(conversationId, file.id));
    const a = document.createElement('a');
    a.href = href;
    a.download = file.name;
    a.click();
  };
  if (isImage && url.data) {
    return (
      <a href={url.data} target="_blank" rel="noreferrer" className="block">
        <img src={url.data} alt={file.name} className="max-h-64 max-w-full rounded-xl" />
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void download()}
      className="flex items-center gap-2 rounded-xl border border-current/20 bg-current/5 px-3 py-2 text-left text-sm"
    >
      <span aria-hidden="true">{'\u{1F4CE}'}</span>
      <span className="min-w-0 truncate font-medium">{file.name}</span>
      <span className="shrink-0 text-xs opacity-70">
        {isImage && url.isPending ? 'Loading...' : sizeText(file.size)}
      </span>
    </button>
  );
}
