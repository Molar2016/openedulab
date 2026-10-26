export type ApiErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'identifier_taken'
  | 'already_authenticated'
  | 'rate_limited'
  | 'payload_too_large'
  | 'state_invalid'
  | 'state_schema_incompatible'
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
