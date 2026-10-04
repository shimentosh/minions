import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./bootstrap";
import { loadConfig } from "./config";

async function main() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: cfg.env === "production" ? ["error", "warn", "log"] : ["error", "warn", "log", "debug"],
  });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
  Logger.log(`Minions API on http://localhost:${cfg.port}`, "Bootstrap");
}

void main();
