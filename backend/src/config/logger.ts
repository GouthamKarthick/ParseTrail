/**
 * config/logger.ts — Winston logger with ECS format and daily rotation.
 */

import fs from "fs";
import path from "path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import dotenv from "dotenv";

dotenv.config();

const LOG_DIR = "./logs";
const LOG_LEVEL = process.env.LOG_LEVEL || "debug";

const logDir = path.resolve(LOG_DIR);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const ecsFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const entry: Record<string, unknown> = {
      "@timestamp": timestamp as string,
      "log.level": level,
      message: (stack as string) || (message as string),
      "ecs.version": "8.11.0",
      service: "claritydocs-backend",
    };
    for (const [k, v] of Object.entries(meta)) {
      if (k === "level" || k === "message") continue;
      entry[k] = v;
    }
    return JSON.stringify(entry);
  }),
);

/**
 * Creates a daily rotate file transport.
 * @param filename Base filename
 * @param level Log level
 * @returns Transport instance
 */
function dailyTransport(filename: string, level: string) {
  return new DailyRotateFile({
    filename: path.join(logDir, `${filename}-%DATE%.log`),
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxSize: "20m",
    maxFiles: "7d",
    level,
    format: ecsFormat,
    auditFile: path.join(logDir, `.audit-${filename}.json`),
  });
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: winston.config.npm.levels,
  transports: [
    dailyTransport("info", "info"),
    dailyTransport("debug", "debug"),
    dailyTransport("warn", "warn"),
    dailyTransport("error", "error"),
    new winston.transports.Console({
      level: LOG_LEVEL,
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(
          ({ timestamp, level, message, stack, ...meta }) => {
            const extra = Object.keys(meta).length
              ? ` ${JSON.stringify(meta)}`
              : "";
            return `${timestamp as string} [${level as string}] ${stack ? (stack as string) : (message as string)}${extra}`;
          },
        ),
      ),
    }),
  ],
});

/**
 * Creates a level filter format.
 * @param lvl Target level
 * @returns Winston format
 */
function levelFilter(lvl: string) {
  return winston.format((info) => (info.level === lvl ? info : false))();
}

for (const t of logger.transports) {
  if (t instanceof DailyRotateFile) {
    const lvl = (t as unknown as { level: string }).level;
    const origFormat = (t as unknown as { format: unknown }).format;
    (t as unknown as { format: unknown }).format = winston.format.combine(
      levelFilter(lvl),
      origFormat as never,
    );
  }
}
