# -*- coding: utf-8 -*-
"""求职智能体 · 桌面桌宠（无边框透明置顶）"""
import json
import os
import threading
import time
import tkinter as tk
import urllib.request
import webbrowser

BG = "#abcdef"  # 透明色（Windows -transparentcolor）
W, H = 240, 200
API = "http://localhost:4173/api/pet-status"
DISMISS = "http://localhost:4173/api/pet-dismiss"
HOME = "http://localhost:4173/"


def round_rect(canvas, x1, y1, x2, y2, r, **kw):
    """圆角矩形"""
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2, x2 - r, y2,
           x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return canvas.create_polygon(pts, smooth=True, **kw)


class DesktopPet:
    def __init__(self):
        self._current = {"message": "", "hint": "overview", "urgent": False}
        self._bubble_hidden = False
        self._dismissed = ""

        self.root = tk.Tk()
        self.root.title("求职桌宠")
        self.root.overrideredirect(True)          # 无边框
        self.root.attributes("-topmost", True)     # 置顶
        self.root.attributes("-transparentcolor", BG)  # 透明
        self.root.configure(bg=BG)

        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"{W}x{H}+{sw - W - 24}+{sh - H - 70}")

        self.canvas = tk.Canvas(self.root, width=W, height=H, bg=BG, highlightthickness=0)
        self.canvas.pack()

        self._build_bubble("连接中…")
        # 桌宠（黄色笑脸）
        self.pet_tag = round_rect(self.canvas, 108, 128, 226, 192, 22, fill="#ffd84d", outline="")
        self.canvas.create_oval(142, 150, 154, 162, fill="#5d4e17", outline="")
        self.canvas.create_oval(180, 150, 192, 162, fill="#5d4e17", outline="")
        self.canvas.create_arc(156, 158, 178, 178, start=200, extent=140,
                               style="arc", outline="#5d4e17", width=4)
        self.canvas.create_oval(126, 166, 140, 180, fill="#ffb07a", outline="")
        self.canvas.create_oval(194, 166, 208, 180, fill="#ffb07a", outline="")

        # 交互：按住任意位置拖动，单击判定点击对象
        self.canvas.bind("<Button-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._move)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self.canvas.bind("<Button-3>", self._menu)

        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="打开求职智能体", command=lambda: webbrowser.open(HOME))
        self.menu.add_command(label="隐藏桌宠", command=self.root.destroy)

        # 恢复上次位置
        pos_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pet_pos.json")
        try:
            with open(pos_file, "r", encoding="utf-8") as f:
                pos = json.load(f)
            self.root.geometry(f"{W}x{H}+{int(pos['x'])}+{int(pos['y'])}")
        except Exception:
            pass

        threading.Thread(target=self._poll, daemon=True).start()

    def _build_bubble(self, text):
        """创建气泡 + 文字 + 关闭按钮"""
        self.bubble_tag = round_rect(self.canvas, 10, 8, 230, 108, 12,
                                     fill="#ffffff", outline="#e5e9f2", width=1)
        self.msg = self.canvas.create_text(
            120, 56, text=text, width=208,
            font=("Microsoft YaHei", 10), fill="#52635e", justify="left")
        self.close_btn = self.canvas.create_text(222, 16, text="×",
                                                 fill="#9aa3b2", font=("Microsoft YaHei", 12, "bold"))
        self.canvas.tag_bind(self.close_btn, "<Button-1>", self._dismiss_bubble)
        self._bubble_hidden = False

    def _dismiss_bubble(self, e=None):
        """点 ×：删除当前气泡提示，并告知服务端不再显示该条"""
        self.canvas.delete(self.bubble_tag)
        self.canvas.delete(self.msg)
        self.canvas.delete(self.close_btn)
        self._bubble_hidden = True
        msg = self._current.get("message", "")
        if msg:
            self._dismissed = msg
            threading.Thread(target=self._send_dismiss, args=(msg,), daemon=True).start()

    def _send_dismiss(self, message):
        try:
            req = urllib.request.Request(DISMISS, data=json.dumps({"message": message}).encode("utf-8"),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    def _press(self, e):
        self._drag = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())
        self._press_xy = (e.x_root, e.y_root)
        self._press_t = time.time()

    def _move(self, e):
        dx, dy = self._drag
        self.root.geometry(f"+{e.x_root - dx}+{e.y_root - dy}")

    def _release(self, e):
        moved = abs(e.x_root - self._press_xy[0]) + abs(e.y_root - self._press_xy[1])
        if moved < 8 and time.time() - self._press_t < 0.5:
            # 单击：点气泡 → 跳转对应页面；点桌宠 → 打开应用
            items = set(self.canvas.find_overlapping(e.x - 2, e.y - 2, e.x + 2, e.y + 2))
            if items and self.bubble_tag in items and self.close_btn not in items:
                webbrowser.open(HOME + "?v=" + self._current.get("hint", "overview"))
            elif items and self.pet_tag in items:
                webbrowser.open(HOME)
        else:
            try:
                pos_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pet_pos.json")
                with open(pos_file, "w", encoding="utf-8") as f:
                    json.dump({"x": self.root.winfo_x(), "y": self.root.winfo_y()}, f)
            except Exception:
                pass

    def _menu(self, e):
        try:
            self.menu.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu.grab_release()

    def _poll(self):
        while True:
            try:
                req = urllib.request.Request(API, headers={"Cache-Control": "no-cache"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    j = json.loads(resp.read().decode("utf-8"))
            except Exception:
                j = {"message": "主服务未连接，请先启动求职智能体应用", "hint": "overview", "urgent": False}
            self.root.after(0, self._update, j)
            time.sleep(30)

    def _update(self, j):
        msg = (j.get("message") or "").strip() or "今天也慢慢推进一件事。"
        urgent = bool(j.get("urgent"))
        self._current = {"message": msg, "hint": j.get("hint", "overview"), "urgent": urgent}

        # 气泡已被 × 关闭且服务端仍返回同一条 → 保持隐藏；新消息则重建气泡
        if self._bubble_hidden and msg == self._dismissed:
            return
        if self._bubble_hidden:
            self._build_bubble(msg)
        else:
            self.canvas.itemconfig(self.msg, text=msg)
        self.canvas.itemconfig(self.msg, fill="#c0392b" if urgent else "#52635e")
        self.canvas.itemconfig(self.pet_tag, fill="#ff5a5a" if urgent else "#ffd84d")
        if urgent:
            self._wiggle()

    def _wiggle(self):
        base = (self.root.winfo_x(), self.root.winfo_y())
        for dx in [3, -3, 3, -3, 2, -2, 0]:
            self.root.geometry(f"+{base[0] + dx}+{base[1]}")
            self.root.update()
            time.sleep(0.05)
        self.root.geometry(f"+{base[0]}+{base[1]}")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    DesktopPet().run()