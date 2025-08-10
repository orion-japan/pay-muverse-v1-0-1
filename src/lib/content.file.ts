import type { ContentProvider, HomeContent } from '@/lib/content';
import { homeContent } from '@/data/home';

export const FileContentProvider: ContentProvider = {
  async getHomeContent(): Promise<HomeContent> {
    return homeContent;
  },
};
