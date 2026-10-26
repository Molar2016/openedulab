export type ApiErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'validation_failed'
  | 'payload_too_large'
  | 'server_error';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export function apiError(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}
