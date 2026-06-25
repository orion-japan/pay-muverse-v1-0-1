import BooksClient from './BooksClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata = {
  title: 'Mu Book 本棚 | Muverse',
};

export default function BooksPage() {
  return <BooksClient />;
}
