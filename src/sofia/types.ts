// sofia/types.ts
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  uploaded_image_urls?: string[];
  isPreview?: boolean;
};

export type PostMessageParams = {
  query: string;
  user: string; // user_code
  conversation_id?: string;
  response_mode?: 'blocking';
  inputs?: Record<string, any>;
  files?: Array<{
    type: 'image';
    transfer_method: 'local_file';
    upload_file_id: string;
  }>;
};
