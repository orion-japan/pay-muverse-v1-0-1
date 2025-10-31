import styles from './UserInfoBadge.module.css';

export type IrosQCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type UserInfoBadgeProps = {
  name: string;
  q: IrosQCode;
};

export default function UserInfoBadge({ name, q }: UserInfoBadgeProps) {
  return (
    <span className={styles.badge} data-testid="userinfo-badge">
      <span className={styles.name}>{name}</span>
      <span className={styles.separator}>/</span>
      <span className={styles.qcode}>{q}</span>
    </span>
  );
}
