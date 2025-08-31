export type Message = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    uploaded_image_urls?: string[];
    isPreview?: boolean;
    created_at?: string;
  };
  
  export type PostMessageParams = {
    query: string;
    user: string;
    conversation_id?: string;
    response_mode?: 'blocking' | 'streaming';
    inputs?: Record<string, any>;
    files?: Array<{
      type: 'image';
      transfer_method: 'local_file';
      upload_file_id: string;
    }>;
  };
  