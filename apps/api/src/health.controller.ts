import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "./common/auth-context";
import { PrismaService } from "./common/prisma.service";

/** Liveness for the container healthcheck: the process answers and the database does too. */
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
