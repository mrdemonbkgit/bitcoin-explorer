export class AppError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options) {
    super(message, 400, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options) {
    super(message, 404, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options) {
    super(message, 503, options);
  }
}
