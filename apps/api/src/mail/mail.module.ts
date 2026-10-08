import { Global, Module } from "@nestjs/common";
import { Mailer } from "./mailer";

/** One Mailer for every module that sends mail (verification, share invitations). */
@Global()
@Module({ providers: [Mailer], exports: [Mailer] })
export class MailModule {}
