/**
 * @fileoverview Upload page — multi-file selection, client-side validation,
 * and sequential per-file upload with per-file status.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadDocument, ApiError } from '../api/client';
import { useToastContext, kindFromStatus } from '../context/ToastContext';
import { validateUploadFile } from '../utils/security';
import { Button } from '../components/ui/Button';
import { Heading } from '../components/ui/Heading';
import { Text } from '../components/ui/Text';
import styles from './Upload.module.scss';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const MAX_FILES = 10;

type UploadItemStatus =
  'waiting' | 'uploading' | 'done' | 'duplicate' | 'failed' | 'skipped' | 'not-sent';

type UploadItem = {
  id: string;
  file: File;
  status: UploadItemStatus;
  error?: string;
  docId?: string;
  docName?: string;
};

function statusLabel(status: UploadItemStatus): string {
  switch (status) {
    case 'waiting':
      return 'Waiting';
    case 'uploading':
      return 'Uploading…';
    case 'done':
      return 'Done';
    case 'duplicate':
      return 'Duplicate';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    case 'not-sent':
      return 'Not sent';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Document upload page. Accepts up to MAX_FILES per selection and uploads them
 * one after another using the existing single-file upload endpoint.
 * @returns Upload page element
 * @example <Upload />
 */
export default function Upload() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [language, setLanguage] = useState('auto');
  const [processing, setProcessing] = useState(false);
  const { show } = useToastContext();
  const nav = useNavigate();

  const waitingItems = items.filter(i => i.status === 'waiting');
  const hasItems = items.length > 0;
  const disabled = processing || !hasItems || waitingItems.length === 0;

  /**
   * Handle native file input change with per-file validation.
   * Invalid files are recorded as "skipped" and are not uploaded.
   * @param e - Input change event
   */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = '';
      if (files.length === 0) return;
      const added: UploadItem[] = [];
      const stamp = Date.now();
      const errors: string[] = [];
      for (let i = 0; i < files.length && added.length < MAX_FILES; i++) {
        const f = files[i];
        const validationError = validateUploadFile(f);
        if (validationError) {
          added.push({ id: `${stamp}-${i}`, file: f, status: 'skipped', error: validationError });
          errors.push(validationError);
        } else {
          added.push({ id: `${stamp}-${i}`, file: f, status: 'waiting' });
        }
      }
      setItems(prev => [...prev, ...added]);
      if (errors.length > 0) {
        show('warning', errors.join('; '));
      }
    },
    [show]
  );

  /**
   * Upload queued files sequentially, never in parallel.
   * @returns void
   */
  async function processQueue() {
    const todo = items.filter(i => i.status === 'waiting');
    if (todo.length === 0) return;
    setProcessing(true);
    try {
      for (const item of todo) {
        setItems(prev => prev.map(i => (i.id === item.id ? { ...i, status: 'uploading' } : i)));
        try {
          const res = await uploadDocument(item.file, language === 'auto' ? undefined : language);
          setItems(prev =>
            prev.map(i =>
              i.id === item.id ? { ...i, status: 'done', docId: res.id, docName: res.name } : i
            )
          );
          show('success', `Uploaded ${res.name} — extracting…`);
        } catch (e) {
          const err = e as ApiError;
          if (
            err.status === 409 &&
            (err.code === 'DUPLICATE_CONTENT' || err.code === 'DUPLICATE_UPDATED')
          ) {
            setItems(prev =>
              prev.map(i =>
                i.id === item.id
                  ? { ...i, status: 'duplicate', error: err.message, docId: err.duplicateOf }
                  : i
              )
            );
            show(
              'warning',
              err.duplicateOf
                ? 'This looks like a duplicate of an existing document.'
                : 'This looks like a duplicate of an existing document.'
            );
            if (err.duplicateOf) nav(`/documents/${err.duplicateOf}`);
          } else if (err.status === 429) {
            // Rate limit hit: stop the queue and mark remaining files not sent.
            setItems(prev =>
              prev.map(i => (i.status === 'waiting' ? { ...i, status: 'not-sent' } : i))
            );
            show('error', 'Too many uploads, try again in a minute');
            break;
          } else {
            setItems(prev =>
              prev.map(i =>
                i.id === item.id
                  ? { ...i, status: 'failed', error: err.message || 'Upload failed' }
                  : i
              )
            );
            const kind = err.status ? kindFromStatus(err.status) : 'error';
            show(kind, err.message || 'Upload failed');
          }
        }
      }
    } finally {
      setProcessing(false);
    }
  }

  /**
   * Reset the upload page to its initial state.
   */
  function resetUpload() {
    setItems([]);
    setProcessing(false);
    setLanguage('auto');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (input) input.value = '';
  }

  return (
    <div className="page">
      <div className={styles['upload-card']}>
        <Heading level={1}>Upload document</Heading>
        <Text variant="muted">
          PDF, PNG, JPG — max 10MB. Up to {MAX_FILES} files at a time, uploaded one after another.
        </Text>

        {items.length > 0 && (
          <div className={styles['upload-list']}>
            {items.map(item => (
              <div key={item.id} className={styles['upload-item']}>
                <span className={styles['upload-item-name']} title={item.file.name}>
                  {item.file.name}
                </span>
                <span
                  className={`${styles['upload-item-status']} ${styles[`upload-item-status-${item.status}`]}`}
                >
                  {statusLabel(item.status)}
                </span>
                {item.status === 'done' && item.docId && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => nav(`/documents/${item.docId}`)}
                  >
                    View document
                  </Button>
                )}
                {item.status === 'duplicate' && item.docId && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => nav(`/documents/${item.docId}`)}
                  >
                    View existing
                  </Button>
                )}
              </div>
            ))}
            {items.some(i => i.status === 'not-sent') && (
              <Text variant="small" className={styles['upload-error']}>
                Remaining files were not sent — too many uploads.
              </Text>
            )}
          </div>
        )}

        <form onSubmit={e => e.preventDefault()} className={styles['upload-form']}>
          <label className={styles['upload-dropzone']}>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              multiple
              onChange={handleFileChange}
              className={styles['upload-file-input']}
              disabled={processing}
            />
            <span className={styles['upload-drop-text']}>
              {hasItems ? `${items.length} file(s) ready` : 'Drop files here or click to browse'}
            </span>
            <span className={styles['upload-drop-hint']}>Supported: .pdf .png .jpg .jpeg</span>
          </label>

          <label className={styles['upload-language']}>
            <span>Document language</span>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              disabled={processing}
            >
              <option value="auto">Auto / English</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="it">Italian</option>
              <option value="nl">Dutch</option>
              <option value="pt">Portuguese</option>
            </select>
            <Text variant="small" className={styles['upload-language-hint']}>
              Auto-detects the language. For scanned non-English documents pick the language
              explicitly.
            </Text>
          </label>

          <div className={styles['upload-actions']}>
            <Button
              type="submit"
              disabled={disabled}
              variant="primary"
              size="md"
              onClick={() => processQueue()}
            >
              {processing ? 'Extracting…' : 'Upload'}
            </Button>
            {hasItems && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={resetUpload}
                disabled={processing}
              >
                Clear list
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
