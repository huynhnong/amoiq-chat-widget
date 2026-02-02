/**
 * Anonymous file upload for Chat Widget (presigned flow).
 * POST /api/gw/v1/webchat/conversations/:conversationId/upload/init -> PUT to S3 -> POST .../upload/complete
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api-gateway-dfcflow.fly.dev';

export interface UploadResult {
  publicUrl: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface InitUploadResponse {
  success: boolean;
  data: {
    uploadUrl: string;
    fileId: number;
    uploadToken: string;
    expiresIn: number;
    fileName: string;
    contentType: string;
  };
  message: string;
}

export interface CompleteUploadResponse {
  success: boolean;
  data: {
    publicUrl: string;
    filename: string;
    size: number;
    contentType: string;
  };
  message: string;
}

export type GetHeaders = () => HeadersInit;

/**
 * Upload service for anonymous Chat Widget users.
 * Uses conversation ID to scope uploads (no auth).
 */
export class UploadService {
  private baseUrl: string;
  private getHeaders: GetHeaders;

  constructor(baseUrl: string = API_BASE_URL, getHeaders?: GetHeaders) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.getHeaders = getHeaders || (() => ({
      'Content-Type': 'application/json',
      ...(process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY
        ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_GATEWAY_API_KEY || process.env.NEXT_PUBLIC_API_KEY}` }
        : {}),
    }));
  }

  /**
   * Request presigned URL for upload (step 1).
   */
  async initUpload(conversationId: string, params: { originalName: string; mimeType: string; size: number }): Promise<InitUploadResponse['data']> {
    const url = `${this.baseUrl}/api/gw/v1/webchat/conversations/${encodeURIComponent(conversationId)}/upload/init`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        originalName: params.originalName,
        mimeType: params.mimeType,
        size: params.size,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      let err: { message?: string } = {};
      try {
        err = text ? JSON.parse(text) : {};
      } catch {
        err = { message: text || response.statusText };
      }
      throw new Error(err.message || `Upload init failed: ${response.status}`);
    }
    const json: InitUploadResponse = await response.json();
    return json.data;
  }

  /**
   * Complete upload after PUT to S3 (step 3).
   */
  async completeUpload(conversationId: string, fileId: number, uploadToken: string): Promise<UploadResult> {
    const url = `${this.baseUrl}/api/gw/v1/webchat/conversations/${encodeURIComponent(conversationId)}/upload/complete`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ fileId, uploadToken }),
    });
    if (!response.ok) {
      const text = await response.text();
      let err: { message?: string } = {};
      try {
        err = text ? JSON.parse(text) : {};
      } catch {
        err = { message: text || response.statusText };
      }
      throw new Error(err.message || `Upload complete failed: ${response.status}`);
    }
    const json: CompleteUploadResponse = await response.json();
    return json.data;
  }

  /**
   * Full flow: init -> PUT file to S3 -> complete. Returns public URL for use in message attachments.
   */
  async uploadFile(conversationId: string, file: File): Promise<UploadResult> {
    const init = await this.initUpload(conversationId, {
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
    });

    const putRes = await fetch(init.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!putRes.ok) {
      throw new Error(`Upload to storage failed: ${putRes.status}`);
    }

    return this.completeUpload(conversationId, init.fileId, init.uploadToken);
  }
}
