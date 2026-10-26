import { useEffect, useRef, useState } from 'react';

export type FeedbackCategory = 'content' | 'bug' | 'other';

export interface FeedbackPayload {
  readonly experimentId: string;
  readonly contentVersion: string;
  readonly appVersion: string;
  readonly category: FeedbackCategory;
  readonly message: string;
}

interface Props {
  experimentId: string;
  contentVersion: string;
  appVersion: string;
  onSubmit: (payload: FeedbackPayload) => Promise<void>;
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
    send: string;
    sending: string;
    sent: string;
    sendFailed: string;
    close: string;
    privacy: string;
  };
}

type SubmitState = { readonly kind: 'idle' } | { readonly kind: 'busy' } | { readonly kind: 'sent' } | { readonly kind: 'failed' };

/**
 * Feedback dialog (design §7.7).
 *
 * The contract with the user is: you see exactly what will be sent (a preview with the
 * concrete fields), and nothing is sent until you press Send. A failure is reported
 * honestly ("not saved, try again") — never a fake confirmation.
 */
export function FeedbackDialog({
  experimentId,
  contentVersion,
  appVersion,
  onSubmit,
  onClose,
  labels,
}: Props): JSX.Element {
  const [category, setCategory] = useState<FeedbackCategory>('content');
  const [message, setMessage] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const payload: FeedbackPayload = {
    experimentId,
    contentVersion,
    appVersion,
    category,
    message: message.trim(),
  };

  const preview = {
    experimentId,
    contentVersion,
    appVersion,
    category,
    messageLength: payload.message.length,
  };

  const send = async (): Promise<void> => {
    if (state.kind === 'busy' || state.kind === 'sent') return;
    setState({ kind: 'busy' });
    try {
      await onSubmit(payload);
      setState({ kind: 'sent' });
    } catch {
      setState({ kind: 'failed' });
    }
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
            maxLength={2000}
            value={message}
            placeholder={labels.messagePlaceholder}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>

        <p className="muted small">{labels.privacy}</p>

        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            onClick={() => setShowPreview(true)}
            disabled={state.kind === 'sent'}
          >
            {labels.preview}
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            {labels.close}
          </button>
        </div>

        {showPreview ? (
          <div className="preview" data-testid="feedback-preview">
            <p className="small">{labels.previewNote}</p>
            <pre>{JSON.stringify(preview, null, 2)}</pre>

            {state.kind === 'sent' ? (
              <p className="muted small" role="status" data-testid="feedback-sent">
                {labels.sent}
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void send()}
                  disabled={state.kind === 'busy'}
                  data-testid="feedback-send"
                >
                  {state.kind === 'busy' ? labels.sending : labels.send}
                </button>
                {state.kind === 'failed' ? (
                  <p role="alert" data-testid="feedback-error">
                    {labels.sendFailed}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
