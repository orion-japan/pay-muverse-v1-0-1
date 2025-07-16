"use client";

import { useState, useEffect, useCallback } from "react";

export default function LogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [ip, setIp] = useState("");
  const [phone, setPhone] = useState("");

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inputId, setInputId] = useState("");
  const [inputPass, setInputPass] = useState("");

  const fetchLogs = useCallback(async () => {
    const params = new URLSearchParams();
    if (ip) params.append("ip", ip);
    if (phone) params.append("phone", phone);

    const res = await fetch(`/api/logs?${params.toString()}`);
    const data = await res.json();
    setLogs(data.logs || []);
  }, [ip, phone]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchLogs();
    }
  }, [isAuthenticated, fetchLogs]);

  function handleLogin() {
    if (inputId === "orion" && inputPass === "123456") {
      setIsAuthenticated(true);
    } else {
      alert("認証に失敗しました");
    }
  }

  function handleExportCSV() {
    const csvRows = [];
    const headers = ["IP Address", "Phone", "Code", "Created"];
    csvRows.push(headers.join(","));

    logs.forEach((log) => {
      const row = [
        log.ip_address,
        log.phone_number,
        log.referral_code,
        log.created_at,
      ];
      csvRows.push(row.join(","));
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("download", "register_logs.csv");
    a.click();
  }

  if (!isAuthenticated) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-bold mb-4">🔑 管理ログイン</h1>
        <input
          type="text"
          placeholder="管理ID"
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          className="border p-2 mr-2"
        />
        <input
          type="password"
          placeholder="パスワード"
          value={inputPass}
          onChange={(e) => setInputPass(e.target.value)}
          className="border p-2 mr-2"
        />
        <button
          onClick={handleLogin}
          className="bg-blue-600 text-white px-4 py-2"
        >
          ログイン
        </button>
      </main>
    );
  }

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">📋 登録ログ履歴</h1>

      <div className="mb-4 flex gap-4">
        <input
          type="text"
          placeholder="IPで検索"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          className="border p-2"
        />
        <input
          type="text"
          placeholder="電話番号で検索"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="border p-2"
        />
        <button
          onClick={fetchLogs}
          className="bg-blue-600 text-white px-4 py-2"
        >
          検索
        </button>

        <button
          onClick={handleExportCSV}
          className="bg-green-600 text-white px-4 py-2"
        >
          CSVエクスポート
        </button>
      </div>

      <table className="w-full border border-gray-300">
        <thead className="bg-gray-100">
          <tr>
            <th className="border px-2 py-1">IP Address</th>
            <th className="border px-2 py-1">Phone</th>
            <th className="border px-2 py-1">Code</th>
            <th className="border px-2 py-1">Created</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="border px-2 py-1">{log.ip_address}</td>
              <td className="border px-2 py-1">{log.phone_number}</td>
              <td className="border px-2 py-1">{log.referral_code}</td>
              <td className="border px-2 py-1">{log.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
