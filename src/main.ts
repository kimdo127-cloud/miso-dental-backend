import 'reflect-metadata';
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiController } from './api.controller';
import { AdminController } from './admin.controller';
import { q } from './db/db';
import { resetAndSeed, ensureDemoTreatments } from './db/seed';

@Module({ controllers: [ApiController, AdminController] })
class AppModule {}

async function bootstrap() {
  // 테이블이 없으면 가상 데이터로 처음 상태를 만든다
  const [t] = await q<{ n: number }>(`select count(*)::int n from information_schema.tables where table_name = 'patients' and table_schema = current_schema()`);
  if (!t.n) await resetAndSeed();
  await ensureDemoTreatments().catch((e) => console.error('demo treatments', e));

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const allowed = (process.env.CORS_ORIGINS || 'http://localhost:3300,http://localhost:3400').split(',');
  // 미소치과 웹앱 · 어드민 배포 주소 (Render · Vercel)
  const ours = /^https:\/\/miso-dental-(web|admin)[a-z0-9-]*\.(onrender\.com|vercel\.app)$/;
  app.enableCors({ origin: (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => cb(null, !o || allowed.includes(o) || ours.test(o)), allowedHeaders: ['Content-Type', 'Authorization', 'X-Patient-Id'] });
  const port = Number(process.env.PORT || 4100);
  await app.listen(port);
  console.log(`miso backend http://localhost:${port}/api`);
}
bootstrap();
