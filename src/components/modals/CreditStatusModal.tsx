import GenericModal from './GenericModal';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  sofiaCredit?: number | null;
  creditUpdatedAt?: string | null;
  contractEndDate?: string | null;
  cardRegistered?: boolean | null;
};

export default function CreditStatusModal({
  isOpen,
  onClose,
  sofiaCredit,
  creditUpdatedAt,
  contractEndDate,
  cardRegistered,
}: Props) {
  return (
    <GenericModal isOpen={isOpen} onClose={onClose} title="クレジット・契約状況">
      <div className="text-sm space-y-2">
        <p>カード登録：{cardRegistered ? '✅ 済み' : '❌ 未登録'}</p>
        <p>契約終了日：{contractEndDate || '未設定'}</p>
        <p>Sofiaクレジット残：
          {typeof sofiaCredit === 'number' ? `${sofiaCredit} クレジット` : '不明'}
        </p>
        <p className="text-xs text-gray-500">最終更新日：{creditUpdatedAt || '不明'}</p>
      </div>
    </GenericModal>
  );
}
