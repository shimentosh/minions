import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadConfig } from "../config";
import { PrismaClient } from "../generated/prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    // Query logging stays off: parameters can include ciphertext and ids we
    // do not want in logs, and there is nothing to gain from it in production.
    super({ adapter: new PrismaPg({ connectionString: loadConfig().databaseUrl }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
