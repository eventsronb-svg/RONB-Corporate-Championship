export class HttpError extends Error {
    statusCode;
    code;
    constructor(statusCode, code, message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
export function assert(condition, status, code, message) {
    if (!condition)
        throw new HttpError(status, code, message);
}
//# sourceMappingURL=errors.js.map