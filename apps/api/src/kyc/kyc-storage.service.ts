import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';

export interface StoredFile {
  storageKey: string;
  iv: string;
  tag: string;
  sha256: string;
}

/**
 * Almacén de documentos KYC cifrados en reposo con AES-256-GCM (Doc. Maestro §20).
 * En producción esto se sustituye por S3/MinIO con cifrado del lado del servidor + KMS.
 */
@Injectable()
export class KycStorageService {
  async save(content: Buffer): Promise<StoredFile> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.kyc.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    const storageKey = `${randomUUID()}.bin`;
    await mkdir(config.kyc.storageDir, { recursive: true });
    await writeFile(this.path(storageKey), encrypted, { flag: 'wx' });
    return {
      storageKey,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  /** Borra un archivo que no llegó a registrarse (la transacción falló). */
  async discard(storageKey: string): Promise<void> {
    await unlink(this.path(storageKey)).catch(() => undefined);
  }

  /** Descifra y verifica integridad (tag GCM y hash del original). */
  async load(file: StoredFile): Promise<Buffer> {
    const encrypted = await readFile(this.path(file.storageKey));
    const decipher = createDecipheriv('aes-256-gcm', config.kyc.encryptionKey, Buffer.from(file.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    const content = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('El documento no coincide con su hash');
    return content;
  }

  private path(storageKey: string) {
    if (!/^[0-9a-f-]{36}\.bin$/.test(storageKey)) throw new Error('Clave de almacenamiento inválida');
    return join(config.kyc.storageDir, storageKey);
  }
}
