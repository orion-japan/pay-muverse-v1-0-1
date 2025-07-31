'use client';

import React from 'react';
import CardForm from './forms/CardForm';   // ✅ ./ に変更！

type Props = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;    // ✅ userCode を必須プロップに
};

export default function CardRegisterModal({ isOpen, onClose, userCode }: Props) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-lg w-96 relative">
        {/* 閉じるボタン */}
        <button
          className="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
          onClick={onClose}
        >
          ✖
        </button>

        {/* タイトル */}
        <h2 className="text-xl font-bold mb-4">💳 カードを登録する</h2>

        {/* ✅ CardForm */}
        <CardForm userCode={userCode} onRegister={onClose} />
      </div>
    </div>
  );
}
