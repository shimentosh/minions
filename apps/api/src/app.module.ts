import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import Redis from "ioredis";
import { AccountModule, CoreServicesModule } from "./account/account.module";
import { AiModule } from "./ai/ai.module";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { EmailVerificationModule } from "./auth/email-verification";
import { PasskeyController, PasskeyService } from "./auth/passkeys";
import { SafeExceptionFilter } from "./common/exception.filter";
import { SessionGuard } from "./common/guards";
import { PrismaModule } from "./common/prisma.service";
import { ImportsModule } from "./imports/imports.module";
import { NotesModule } from "./notes/notes.module";
import { OperatorModule } from "./operator/operator.module";
import { OrganizeModule } from "./organize/organize.module";
import { SecurityModule } from "./security/security.module";
import { SharesModule } from "./shares/shares.module";
import { RotationController, RotationService } from "./vault/rotation";
import { VaultController, VaultService } from "./vault/vault.controller";
import { ItemsController } from "./vault-items/items.controller";
import { ItemsService } from "./vault-items/items.service";
import { WorkspacesModule } from "./workspaces/workspaces.controller";

function throttlerStorage() {
  const url = process.env.REDIS_URL;
  // Tests use Redis only when they ask for it, with their own key prefix.
  if (!url || (process.env.NODE_ENV === "test" && !process.env.MINIONS_TEST_REDIS))
    return undefined;
  const prefix = process.env.MINIONS_THROTTLE_PREFIX ?? "minions:throttle:";
  return new ThrottlerStorageRedisService(
    new Redis(url, { keyPrefix: prefix, lazyConnect: false, maxRetriesPerRequest: 2 }),
  );
}

@Module({
  imports: [
    // Every route: 300 requests/minute per client. Auth routes set tighter limits.
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [{ name: "default", ttl: 60_000, limit: 300 }],
        // Integration tests sign up many users from one address. The throttle
        // tests switch it back on with MINIONS_TEST_THROTTLE=1.
        skipIf: () => process.env.NODE_ENV === "test" && process.env.MINIONS_TEST_THROTTLE !== "1",
        // With Redis, counters are shared, so the limits hold across every
        // API instance. Without it they are per process.
        storage: throttlerStorage(),
      }),
    }),
    PrismaModule,
    EmailVerificationModule,
    CoreServicesModule,
    AccountModule,
    OrganizeModule,
    NotesModule,
    SecurityModule,
    AiModule,
    ImportsModule,
    SharesModule,
    WorkspacesModule,
    OperatorModule,
  ],
  controllers: [
    AuthController,
    PasskeyController,
    VaultController,
    RotationController,
    ItemsController,
  ],
  providers: [
    AuthService,
    PasskeyService,
    VaultService,
    RotationService,
    ItemsService,
    // Order matters: throttle before touching the database for the session.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
  ],
})
export class AppModule {}
