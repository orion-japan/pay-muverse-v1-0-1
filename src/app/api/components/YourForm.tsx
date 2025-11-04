'use client';

import { useState } from 'react';

export default function YourForm() {
  const [formData, setFormData] = useState({
    click_username: '',
    click_email: '',
    Password: '',
    Tcode: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    console.log('✅ 送信データ:', formData);

    const res = await fetch('/api/write-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    const result = await res.json();
    console.log('✅ API Response:', result);

    if (result.status === 'success') {
      window.location.href = '/thanks';
    } else {
      alert('登録に失敗しました: ' + result.message);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4">
      <input
        type="text"
        name="click_username"
        placeholder="ニックネーム"
        value={formData.click_username}
        onChange={handleChange}
        required
        className="border px-4 py-2 w-full"
      />
      <input
        type="email"
        name="click_email"
        placeholder="メールアドレス"
        value={formData.click_email}
        onChange={handleChange}
        required
        className="border px-4 py-2 w-full"
      />
      <input
        type="password"
        name="Password"
        placeholder="パスワード"
        value={formData.Password}
        onChange={handleChange}
        required
        className="border px-4 py-2 w-full"
      />
      <input
        type="text"
        name="Tcode"
        placeholder="SNS認証電話番号"
        value={formData.Tcode}
        onChange={handleChange}
        required
        className="border px-4 py-2 w-full"
      />
      <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded">
        登録する
      </button>
    </form>
  );
}
