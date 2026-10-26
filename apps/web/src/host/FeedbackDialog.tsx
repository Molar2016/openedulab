import { useEffect, useRef, useState } from 'react';

export type FeedbackCategory = 'content' | 'bug' | 'other';

interface Props {
  experimentId: string;
  onClose: () => void;
  labels: {
    title: string;
    category: string;
    categoryContent: string;
    categoryBug: string;
    categoryOther: string;
    message: string;
    messagePlaceholder: string;
    preview: string;
    previewNote: string;
    notSent: string;
    close: string;
    privacy: string;
  };
}

/**
 * Feedback preview only. M1 has no endpoint, so nothing is submitted, stored or logged;
 * the dialog exists to prove the payload is shown to the learner before any future send.
 */
export function FeedbackDialog({ experimentId, onClose, labels }: Props): JSX.Element {
  const [category, setCategory] = useState<FeedbackCategory>('content');
  const [message, setMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const payload = {
    experimentId,
    category,
    messageLength: message.trim().length,
  };

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={labels.title} data-testid="feedback-dialog">
        <h2>{labels.title}</h2>

        <label className="field">
          <span>{labels.category}</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}>
            <option value="content">{labels.categoryContent}</option>
            <option value="bug">{labels.categoryBug}</option>
            <option value="other">{labels.categoryOther}</option>
          </select>
        </label>

        <label className="field">
          <span>{labels.message}</span>
          <textarea
            ref={textareaRef}
            rows={4}
            maxLength={500}
            value={message}
            placeholder={labels.messagePlaceholder}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>

        <p className="muted small">{labels.privacy}</p>

        <div className="dialog__actions">
          <button type="button" className="button" onClick={() => setShowPreview(true)}>
            {labels.preview}
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            {labels.close}
          </button>
        </div>

        {showPreview ? (
          <div className="preview" data-testid="feedback-preview">
            <p className="small">{labels.previewNote}</p>
            <pre>{JSON.stringify(payload, null, 2)}</pre>
            <p className="muted small" role="status">
              {labels.notSent}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
