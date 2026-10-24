export function httpError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
