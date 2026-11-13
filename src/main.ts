import 'reflect-metadata';
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiController } from './api.controller';
import { AdminController } from './admin.controller';
import { q } from './db/db';
import { resetAndSeed } from './db/seed';

@Module({ controllers: [ApiController, AdminController] })
class AppModule {}

async function bootstrap() {
  // 테이블이 없으면 가상 데이터로 처음 상태를 만든다
  const [t] = await q<{ n: number }>(`select count(*)::int n from information_schema.tables where table_name = 'patients' and table_schema = current_schema()`);
  if (!t.n) await resetAndSeed();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (process.env.CORS_ORIGINS || 'http://localhost:3300,http://localhost:3400').split(','), allowedHeaders: ['Content-Type', 'Authorization', 'X-Patient-Id'] });
  const port = Number(process.env.PORT || 4100);
  await app.listen(port);
  console.log(`miso backend http://localhost:${port}/api`);
}
bootstrap();
