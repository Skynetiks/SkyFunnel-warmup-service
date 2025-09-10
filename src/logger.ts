// winston.config.js
import winston from "winston";
import "winston-daily-rotate-file";
import { CreateIssueInDB } from "./helpers/database";

// Define the logging formats
const fileFormat = winston.format.combine(
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss",
  }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

const errorFileFormat = winston.format.combine(
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss",
  }),
  winston.format.printf(
    (info) => `
================================================================================
${info.timestamp} [${info.level}]: ${info.message}
context: ${JSON.stringify(info.context, null, 2)}
probableCauses: ${
      Array.isArray(info.probableCauses)
        ? info.probableCauses.join(", ")
        : info.probableCauses
    }
    
================================================================================
    `
  )
);

interface Info {
  timestamp?: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  probableCauses?: string[];
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: "HH:mm:ss",
  }),
  winston.format.printf(
    (info) => `${info.timestamp} [${info.level}]: ${info.message}`
  )
);

// Create transports
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
});

const combinedFileTransport = new winston.transports.DailyRotateFile({
  filename: "%DATE%_combined.log",
  format: fileFormat,
  datePattern: "YYYY-MM-DD-HH",
  maxSize: "40m",
  dirname: "logs/combined",
  maxFiles: "14d",
});

const errorFileTransport = new winston.transports.DailyRotateFile({
  filename: "%DATE%_error.log",
  level: "error",
  format: errorFileFormat,
  datePattern: "YYYY-MM-DD-HH",
  maxSize: "30m",
  dirname: "logs/errors",
  maxFiles: "14d",
});

// Create the logger instance
const logger = winston.createLogger({
  levels: winston.config.syslog.levels,
  transports: [errorFileTransport, combinedFileTransport, consoleTransport],
});

// Logger class with static methods
type LEVELS = "error" | "warn" | "info" | "debug" | "verbose" | "silly";
class Logger {
  // Base log method
  private static log(
    level: LEVELS,
    message: string,
    context?: Record<string, unknown>,
    probableCauses?: string[]
  ): void {
    const logMessage = {
      message,
      context,
      probableCauses,
    };
    logger.log(level, logMessage);
  }

  // Static method for info logging
  static info(
    message: string,
    context?: Record<string, unknown>,
    probableCauses?: string[]
  ): void {
    this.log("info", message, context, probableCauses);
  }

  // Static method for error logging
  static error(
    message: string,
    context?: Record<string, unknown>,
    probableCauses?: string[]
  ): void {
    this.log("error", message, context, probableCauses);
    CreateIssueInDB({
      title: message,
      description: message,
      priority: "MEDIUM",
      probableCauses: probableCauses || [],
      context: context || {},
    });
  }

  // Static method for critical errors
  static criticalError(
    message: string,
    context?: Record<string, unknown>,
    probableCauses?: string[]
  ): void {
    this.log("error", message, context, probableCauses); // Log as an error
    CreateIssueInDB({
      title: message,
      description: message,
      priority: "HIGH",
      probableCauses: probableCauses || [],
      context: context || {},
    });
    // Additional logic for critical errors can go here
  }

  // Static method for warnings
  static warn(
    message: string,
    context?: Record<string, unknown>,
    probableCauses?: string[]
  ): void {
    this.log("warn", message, context, probableCauses);
  }
}

export default Logger;
