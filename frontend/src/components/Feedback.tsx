/**
 * @fileoverview EmptyState and ErrorState — consistent dead-end screens with actions.
 */

import { Link } from 'react-router-dom';
import { TextBlock } from './ui/Text';
import { Button } from './ui/Button';
import styles from './Feedback.module.scss';

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Empty state with an optional call to action.
 * @param icon - Bootstrap icon name (without bi prefix)
 * @param title - Heading text
 * @param message - Body text
 * @param actionTo - Optional link target
 * @param actionLabel - Optional link label
 * @returns Empty state element
 * @example <EmptyState icon="cloud-arrow-up" title="No documents" message="..." actionTo="/" actionLabel="Upload one" />
 */
export function EmptyState({
  icon,
  title,
  message,
  actionTo,
  actionLabel,
}: {
  icon: string;
  title: string;
  message: string;
  actionTo?: string;
  actionLabel?: string;
}) {
  return (
    <div className={styles.feedback}>
      <i className={`bi bi-${icon}`} aria-hidden />
      <TextBlock htmlTag="p">
        <strong>{title}</strong>
      </TextBlock>
      <TextBlock textStyle="muted" htmlTag="p">
        {message}
      </TextBlock>
      {actionTo && actionLabel && (
        <Link to={actionTo} className={styles['feedback-action']}>
          {actionLabel}
        </Link>
      )}
    </div>
  );
}

/**
 * Error state with retry affordance.
 * @param message - Error text
 * @param onRetry - Optional retry handler
 * @returns Error state element
 * @example <ErrorState message="Failed" onRetry={reload} />
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.feedback} role="alert">
      <i className="bi bi-exclamation-triangle" aria-hidden />
      <TextBlock htmlTag="p">{message}</TextBlock>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
