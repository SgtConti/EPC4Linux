// Error type shared by the DDC/CI layer. Callers only need to know whether an operation failed and
// why (for logs); the vendor code maps every failure to "not supported" (err_code 9, 06 §2.3).

export type DdcErrorCode =
  /** A transfer on the transport failed (USB control transfer, i2c read/write syscall). */
  | 'io'
  /** A reply arrived but failed validation (source byte, length, checksum, opcode). */
  | 'invalid-reply'
  /** No transport is usable for this monitor (none present, or all failed the support probe). */
  | 'no-transport'
  /** The monitor answered with a DDC/CI null message or a vendor query it does not implement. */
  | 'unsupported'
  /** The channel or transport was closed. */
  | 'closed'
  /** Bad argument (VCP code, value range, frame length). */
  | 'argument'
  /**
   * Another process held the cross-process DDC lock for too long (20 §2.4). Retrying or failing over
   * cannot help, so every retry loop passes it straight through (see {@link isBusy}).
   */
  | 'busy';

export class DdcError extends Error {
  readonly code: DdcErrorCode;
  /** Transport the failure happened on, when known (e.g. "via:usb:3-2.4"). */
  readonly transportId: string | undefined;

  constructor(code: DdcErrorCode, message: string, transportId?: string, options?: { cause?: unknown }) {
    super(transportId ? `${message} [${transportId}]` : message, options);
    this.name = 'DdcError';
    this.code = code;
    this.transportId = transportId;
  }
}

export function isDdcError(e: unknown): e is DdcError {
  return e instanceof DdcError;
}

export function isBusy(e: unknown): boolean {
  return e instanceof DdcError && e.code === 'busy';
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
