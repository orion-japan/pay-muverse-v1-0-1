Date.prototype.toLocaleString = function (l?: string | string[], o?: Intl.DateTimeFormatOptions) {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...(o || {}) }).format(this);
  };
  Date.prototype.toLocaleDateString = Date.prototype.toLocaleString;
  Date.prototype.toLocaleTimeString = Date.prototype.toLocaleString;
  