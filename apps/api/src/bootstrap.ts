import { INestApplication, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { loadConfig } from "./config";

/** Shared by main.ts and the integration tests, so tests run the real stack. */
export function configureApp(app: INestApplication) {
  const cfg = loadConfig();
  const express = app as NestExpressApplication;
  express.set("trust proxy", cfg.trustProxy);
  express.disable("x-powered-by");
  express.useBodyParser("json", { limit: "3mb" });
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    }),
  );
  app.use(cookieParser());
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    // API responses can contain ciphertext and metadata; never cache them.
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.enableCors({
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-minions-client"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true);
      if (cfg.webOrigins.includes(origin) || cfg.extensionOrigins.includes(origin))
        return cb(null, true);
      if (
        cfg.env !== "production" &&
        cfg.extensionOrigins.length === 0 &&
        origin.startsWith("chrome-extension://")
      )
        return cb(null, true);
      cb(null, false);
    },
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Validation errors name the property, never echo the value.
      validationError: { target: false, value: false },
    }),
  );
}
