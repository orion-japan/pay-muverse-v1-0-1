'use client';
import Image, { ImageProps } from 'next/image';

type Props = Omit<ImageProps, 'fill'> & {
  aspectRatio?: `${number}/${number}`;
  className?: string;
};

export default function SafeImage({
  src,
  alt,
  aspectRatio = '1/1',
  className,
  style,
  ...rest
}: Props) {
  return (
    <div
      style={{ position: 'relative', width: '100%', aspectRatio, ...style }}
      className={className}
    >
      <Image src={src} alt={alt ?? ''} fill unoptimized style={{ objectFit: 'cover' }} {...rest} />
    </div>
  );
}
