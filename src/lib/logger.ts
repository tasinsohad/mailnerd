type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  userId?: string;
  requestId?: string;
  [key: string]: unknown;
}

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: LogContext;
  error?: {
    message: string;
    stack?: string;
  };
}

function formatLogEntry(entry: LogEntry): string {
  const base = {
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    ...entry.context,
  };

  if (entry.error) {
    return JSON.stringify({ ...base, error: entry.error });
  }

  return JSON.stringify(base);
}

function log(level: LogLevel, message: string, context?: LogContext, error?: Error) {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
    ...(error && {
      error: {
        message: error.message,
        stack: error.stack,
      },
    }),
  };

  const formatted = formatLogEntry(entry);

  switch (level) {
    case "debug":
      console.debug(formatted);
      break;
    case "info":
      console.log(formatted);
      break;
    case "warn":
      console.warn(formatted);
      break;
    case "error":
      console.error(formatted);
      break;
  }
}

export const logger = {
  debug(message: string, context?: LogContext) {
    log("debug", message, context);
  },

  info(message: string, context?: LogContext) {
    log("info", message, context);
  },

  warn(message: string, context?: LogContext) {
    log("warn", message, context);
  },

  error(message: string, error?: Error, context?: LogContext) {
    log("error", message, context, error);
  },

  withContext(context: LogContext) {
    return {
      debug: (message: string) => log("debug", message, context),
      info: (message: string) => log("info", message, context),
      warn: (message: string) => log("warn", message, context),
      error: (message: string, error?: Error) => log("error", message, context, error),
    };
  },
};

export function createRequestLogger(request: Request) {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  return {
    requestId,
    logRequest(method: string, path: string, userId?: string) {
      logger.info(`${method} ${path}`, { requestId, userId, method, path });
    },
    logResponse(status: number, error?: Error) {
      const duration = Date.now() - startTime;
      const level = status >= 400 ? "warn" : "info";
      log(level, `Response ${status}`, { requestId, status, duration });
    },
    logError(message: string, error: Error) {
      logger.error(message, error, { requestId });
    },
  };
}
