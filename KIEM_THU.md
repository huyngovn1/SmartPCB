# Tình trạng kiểm thử SmartPCB 3.0

Kiểm tra ngày 08/10/2026 trên Node.js v24.18.0.

| Phần | Kết quả |
|---|---|
| Bố trí | 12 tình huống qua: khóa vị trí, dịch pad cùng linh kiện, vùng lõm, khe cắt, keepout, bảo vệ phần đã đi dây, không đủ chỗ, tính lặp lại. |
| Đi dây | 20 tình huống qua: đúng Preferred Width, khoảng cách/vật cản, lớp được phép, via xuyên lớp, bảo vệ plane chưa mô hình hóa, pad xoay, kết nối với đồng cũ, kết nối còn lại và giới hạn tìm kiếm. |
| Tích hợp | 14 kiểm thử qua: bố trí + đi dây, danh tính linh kiện/net trong TSV, arc thuận/ngược, file thành công/lỗi, config hỏng, dữ liệu nhập sai và tính nhất quán pad/khung bao. |
| Gọi Node qua PowerShell ẩn | Thành công, kể cả đường dẫn thư mục kết quả có dấu cách; tạo `done.txt` với `OK` và đủ file phương án. |
| Adapter DelphiScript trong AD16.1 | **Chưa chạy hoặc biên dịch trong Altium.** Chỉ đối chiếu API và rà soát mã. |
| PCB TouchGFX thực tế của người dùng | **Chưa áp dụng/kiểm thử.** Chưa có số liệu chất lượng đi dây trên board đó. |

Mẫu `fixtures/sample-board.json` có 5 linh kiện, mép board lõm, khe cắt, keepout, đầu nối cố định và độ rộng nguồn 3V3 = 0,6 mm. Phương án mẫu di chuyển 3 linh kiện, thêm 21 track và 1 via, nối đủ các nhóm đồng được mô hình hóa. Mẫu nhỏ không chứng minh khả năng đi đủ dây trên PCB lớn.

Benchmark nhân tạo tùy chọn `node test-router.js --benchmark`: 40 linh kiện, 113 pad, 4 lớp tín hiệu, giới hạn 30.000 lần mở rộng tìm kiếm. Đi được 42/86 lần nối, thêm 77 track, còn 44 lần nối được báo chưa xử lý. Bộ kiểm tra hình học không báo lỗi. Giới hạn tìm kiếm cố ý thấp; kết quả này không phải đánh giá PCB TouchGFX hay so sánh với Situs.

Không có kết quả DRC, timing, impedance hoặc kiểm tra chế tạo thực tế. `HUONG_DAN.md` mô tả chính xác phạm vi và các trường hợp để lại cho đi tay.
