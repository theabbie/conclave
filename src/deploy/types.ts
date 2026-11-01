export interface SourceFile {
  path: string;
  content: string;
  sha256: string;
}

export interface SourceArchive {
  schema: 1;
  revision: string;
  files: SourceFile[];
}

export interface ReleasePayload {
  baseVersion: string;
  source: SourceArchive;
  artifact: { content: string; sha256: string };
  checks: { sourceRevision: string; artifactSha256: string; passed: string[] };
}

export interface ReleaseReceipt {
  receipt: {
    versionId: string;
    baseVersion: string;
    sourceRevision: string;
    artifactSha256: string;
    expiresAt: number;
  };
  signature: string;
}
