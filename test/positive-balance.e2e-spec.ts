import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { generateId } from '../src/utils/id';
import { sleep } from '../src/utils/timer';

describe('Positive balance after concurrent transactions test', () => {
  let app: INestApplication<App>;
  let accessToken: string;
  let toAccountId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const accountPayload = {
      email: `user_${Date.now()}_${Math.random()}@test.com`,
      password: 'Test123@',
    };
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(accountPayload);
    const firstAccountLoginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send(accountPayload);
    const destinationAccountRegisterResponse = await request(
      app.getHttpServer(),
    )
      .post('/auth/register')
      .send({
        ...accountPayload,
        email: `user_${Date.now()}_${Math.random()}@test.com`,
      });
    accessToken = firstAccountLoginResponse.body.accessToken;
    toAccountId = destinationAccountRegisterResponse.body.data.id;
  });

  afterEach(async () => {
    await app.close();
  });

  it('the final balance should never be negative after multiple transactions', async () => {
    const concurrentTransactions = Array.from({ length: 20 }, async () => {
      await request(app.getHttpServer())
        .post('/transfer')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('X-Idempotency-Key', generateId('ik'))
        .send({ amount: 30, toAccountId });

      await sleep(100);
    });

    await Promise.allSettled(concurrentTransactions);

    const balanceResponse = await request(app.getHttpServer())
      .get('/balance')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    console.log({ balanceResponse: balanceResponse.body });
    // the result may not be 10 due to serialization behavior, but most importantly, the balance is never negative
    expect(balanceResponse.body.balance).toBeGreaterThanOrEqual(0);
  });
});
