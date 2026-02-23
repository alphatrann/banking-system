import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MINIO } from './minio.decorator';
import * as Minio from 'minio';

@Global()
@Module({
  exports: [MINIO],
  providers: [
    {
      inject: [ConfigService],
      provide: MINIO,
      useFactory: async (
        configService: ConfigService,
      ): Promise<Minio.Client> => {
        const client = new Minio.Client({
          endPoint: configService.getOrThrow('MINIO_ENDPOINT'),
          port: +configService.getOrThrow('MINIO_PORT'),
          accessKey: configService.getOrThrow('MINIO_ACCESS_KEY'),
          secretKey: configService.getOrThrow('MINIO_SECRET_KEY'),
          useSSL: configService.get('NODE_ENV') === 'production',
        });
        return client;
      },
    },
  ],
})
export class MinioModule {}
