/**
 * @fileoverview Upload page — file selection, suspicious-name guard, client-side validation, and document upload flow.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadDocument, ApiError } from '../api/client';
import { useToastContext, kindFromStatus } from '../context/ToastContext';
import { isSuspiciousFrontend, validateUploadFile } from '../utils/security';
import { Button } from '../components/ui/Button';
import { Heading } from '../components/ui/Heading';
import { Text } from '../components/ui/Text';
import styles from './Upload.module.scss';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Upload lifecycle state.
 * - idle: no upload in progress
 * - uploading: file sent to backend, awaiting response
 * - queued: backend accepted (202), extraction running in background worker
 */
type UploadState = 'idle' | 'uploading' | 'queued';

/**
 * Document upload page.
 * @returns Upload page element
 * @example <Upload />
 */
export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('auto');
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedDoc, setUploadedDoc] = useState<{ id: string; name: string } | null>(null);
  const { show } = useToastContext();
  const nav = useNavigate();

  /**
   * Handle native file input change with frontend security check.
   * @param e - Input change event
   */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      if (f && isSuspiciousFrontend(f.name)) {
        show('warning', 'Suspicious file name detected — not saved');
        e.target.value = '';
        return;
      }
      if (!f) return;
      const validationError = validateUploadFile(f);
      if (validationError) {
        show('warning', validationError);
        e.target.value = '';
        return;
      }
      setFile(f);
      setUploadError(null);
      setUploadedDoc(null);
    },
    [show]
  );

  /**
   * Submit selected file to backend.
   * @param e - Form submit event
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const fileToUpload = file;
    if (isSuspiciousFrontend(fileToUpload.name)) {
      show('warning', 'Suspicious file name detected — not saved');
      return;
    }
    const validationError = validateUploadFile(fileToUpload);
    if (validationError) {
      show('warning', validationError);
      return;
    }
    setUploadState('uploading');
    setUploadError(null);
    try {
      const res = await uploadDocument(fileToUpload, language === 'auto' ? undefined : language);
      // 202 accepted — extraction runs in background worker
      setUploadState('queued');
      setUploadedDoc({ id: res.id, name: res.name });
      show('success', `Uploaded ${res.name} — extracting…`);
    } catch (e) {
      setUploadState('idle');
      const err = e as ApiError;
      if (
        err.status === 409 &&
        (err.code === 'DUPLICATE_CONTENT' || err.code === 'DUPLICATE_UPDATED')
      ) {
        show(
          'warning',
          `Duplicate document — updated existing record (id ${err.duplicateOf ?? ''}). Not added as new.`
        );
        if (err.duplicateOf) nav(`/documents/${err.duplicateOf}`);
      } else if (err.code === 'SUSPICIOUS_INPUT') {
        show('warning', err.message || 'Suspicious input detected — not saved');
      } else {
        const kind = err.status ? kindFromStatus(err.status) : 'error';
        show(kind, err.message || 'Upload failed');
        setUploadError(err.message || 'Upload failed');
      }
    }
  }

  /**
   * Reset the upload form to its initial state.
   */
  function resetUpload() {
    setFile(null);
    setUploadState('idle');
    setUploadError(null);
    setUploadedDoc(null);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    if (input) input.value = '';
  }

  const isUploading = uploadState === 'uploading';
  const isQueued = uploadState === 'queued';

  return (
    <div className="page">
      <div className={styles['upload-card']}>
        <Heading level={1}>Upload document</Heading>
        <Text variant="muted">
          PDF, PNG, JPG — max 10MB. Scanned images are OCR&apos;d automatically.
        </Text>

        {uploadError && (
          <Text variant="small" className={styles['upload-error']}>
            {uploadError}
          </Text>
        )}

        {isQueued && uploadedDoc && (
          <div className={styles['upload-queued']}>
            <Text variant="muted">Uploaded {uploadedDoc.name} — extracting…</Text>
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => nav(`/documents/${uploadedDoc.id}`)}
            >
              View document
            </Button>
          </div>
        )}

        <form onSubmit={onSubmit} className={styles['upload-form']}>
          <label className={styles['upload-dropzone']}>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={handleFileChange}
              className={styles['upload-file-input']}
              disabled={isUploading || isQueued}
            />
            <span className={styles['upload-drop-text']}>
              {file ? file.name : 'Drop file here or click to browse'}
            </span>
            <span className={styles['upload-drop-hint']}>Supported: .pdf .png .jpg .jpeg</span>
          </label>

          <label className={styles['upload-language']}>
            <span>Document language</span>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              disabled={isUploading || isQueued}
            >
              <option value="auto">Auto / English</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="hi">Hindi</option>
              <option value="ta">Tamil</option>
              <option value="ml">Malayalam</option>
              <option value="kn">Kannada</option>
              <option value="te">Telugu</option>
            </select>
            <Text variant="small" className={styles['upload-language-hint']}>
              Auto-detects the language. For scanned non-English documents pick the language
              explicitly.
            </Text>
          </label>

          <div className={styles['upload-actions']}>
            <Button
              type="submit"
              disabled={!file || isUploading || isQueued}
              variant="primary"
              size="md"
            >
              {isUploading ? 'Uploading…' : isQueued ? 'Extracting…' : 'Upload'}
            </Button>
            {file && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={resetUpload}
                disabled={isUploading || isQueued}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
