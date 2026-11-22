export class ZcApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ZcApiError";
    this.status = status;
    this.data = data;
  }
}
