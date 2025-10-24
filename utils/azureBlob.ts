import { randomUUID } from "node:crypto";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";
import { AZURE } from "@/utils/env";

type UploadOpts = {
  // 上書き用のコンテナ名（既定は AZURE.BLOB_CONTAINER）
  container?: string;
  // アップロード先のパス接頭辞（例: "line-images"）
  prefix?: string;
  // SAS の有効秒数（既定 AZURE.BLOB_SAS_TTL_SEC or 600）
  ttlSec?: number;
};

// ConnectionString からアカウント名・キーを抽出
function parseAccountCredsFromConnStr(conn: string): { accountName: string; accountKey: string } {
  const parts: Record<string, string> = {};
  for (const seg of conn.split(";")) {
    const [k, v] = seg.split("=", 2);
    if (k && v) parts[k.trim()] = v.trim();
  }
  const accountName = parts["AccountName"];
  const accountKey = parts["AccountKey"];
  if (!accountName || !accountKey) {
    throw new Error("Invalid AZURE_BLOB_CONNECTION_STRING: AccountName/AccountKey missing"); // ★
  }
  return { accountName, accountKey };
}

// Blob 名を生成（拡張子は contentType から推定）
function buildBlobName(contentType: string, prefix?: string): string {
  const safePrefix: string = (prefix ?? AZURE.BLOB_UPLOAD_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const id: string = randomUUID();
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "application/pdf": "pdf",
  };
  const ext: string = extMap[contentType] ?? "bin";
  return safePrefix ? `${safePrefix}/${id}.${ext}` : `${id}.${ext}`;
}

// Buffer を Azure Blob にアップロードし、SAS URL を返す
export async function uploadBufferAndGetSasUrl(
  buf: Buffer,
  contentType: string,
  opts: UploadOpts = {}
): Promise<string> {
  const conn: string | undefined = AZURE.BLOB_CONNECTION_STRING;
  const defaultContainer: string | undefined = AZURE.BLOB_CONTAINER;
  const defaultTtl: number = Number(AZURE.BLOB_SAS_TTL_SEC ?? 600);

  if (!conn) throw new Error("AZURE_BLOB_CONNECTION_STRING is not set");
  const containerName: string = (opts.container ?? defaultContainer ?? "").trim();
  if (!containerName) throw new Error("AZURE_BLOB_CONTAINER is not set");
  if (!(buf instanceof Buffer) || buf.length === 0) throw new Error("uploadBufferAndGetSasUrl: empty buffer");

  // クライアント初期化
  const service: BlobServiceClient = BlobServiceClient.fromConnectionString(conn);
  const container = service.getContainerClient(containerName);
  // 非公開コンテナとして作成（public access を指定しない）
  await container.createIfNotExists();

  // Blob アップロード
  const blobName: string = buildBlobName(contentType, opts.prefix);
  const blob = container.getBlockBlobClient(blobName);
  await blob.uploadData(buf, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "public, max-age=60",
    },
  });

  // SAS 生成（読み取りのみ）
  const { accountName, accountKey } = parseAccountCredsFromConnStr(conn);
  const cred = new StorageSharedKeyCredential(accountName, accountKey);
  const expires = new Date(Date.now() + 1000 * (opts.ttlSec ?? defaultTtl));
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: new Date(Date.now() - 30_000), // 時計ずれ吸収
      expiresOn: expires,
    },
    cred
  ).toString();

  const url: string = `${blob.url}?${sas}`;
  return url;
}
