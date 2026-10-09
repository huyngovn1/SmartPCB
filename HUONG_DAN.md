# Sửa SmartAuto không tạo dây vì pad bị đánh dấu không hỗ trợ

Đã kiểm tra bản `SmartPCB_AD2016_v3.rar` bạn gửi và lần test
`D:\down\SmartPCB_AD2016_v3\SmartPCB_AD2016\runtime\20261008_161111`.

Lần test đó có 192 net, 191 net được đưa vào diện xử lý thủ công,
154/167 linh kiện bị khóa trong dữ liệu xuất, 0 đoạn dây mới và 0 via mới.
Các lý do chính là `Pad copper bounds do not match a centered simple pad`
và `Non-rectangular/round pad geometry`.

## Nguyên nhân

Hàm `SP_PadJSON` so kích thước đồng với `Pad.BoundingRectangle`.
Trong PCB này, khung đó bao gồm cả solder mask expansion. Ví dụ pad C20/1
có đồng khoảng 0,49 × 0,60 mm, nhưng khung trả về khoảng 0,6932 × 0,8032 mm,
do mask mở rộng 0,1016 mm mỗi phía. Đổi tolerance từ 0,005 mm lên cao hơn
không sửa đúng phép so sánh.

PCB cũng có 220 pad Rounded Rectangle. Router cũ chỉ nhận `rect` và `round`;
nó không đọc bán kính bo góc của kiểu pad này.

Còn một lỗi độc lập: `SP_Export` đọc Board Region định nghĩa layer stack
thành một vùng cấm trên mọi lớp. Vùng `Layer Stack Region 1` này có khung
bao phủ toàn PCB (127 × 102,466 mm), nên router không tìm được điểm bắt đầu.
Gói sửa lọc vai trò `eViewableObject_BoardRegion` trước khi đọc keepout flags,
và phân biệt region đồng, polygon cutout, board cutout. Vùng cấm thực,
board cutout và cavity vẫn được giữ.

## Cách áp dụng

1. Sao lưu ba file trong thư mục tool đang dùng:
   `SmartPCB_AD2016.pas`, `router.js`, `smartpcb.js`.
2. Chép ba file cùng tên trong gói sửa này vào:
   `D:\down\SmartPCB_AD2016_v3\SmartPCB_AD2016\`.
   Đây là thư mục chứa `config.json`, `placer.js` và `SmartPCB_AD2016.PrjScr`.
   Giữ `config.json` hiện có với `maxCells: 4000000`.
3. Đóng rồi mở lại script project `SmartPCB_AD2016.PrjScr` trong Altium
   từ đúng thư mục trên để nạp mã mới.
4. Mở PCB bạn muốn xử lý, chạy `PreviewSmart` trước.
   Xem báo cáo mới: số net bị bảo vệ do hai lý do trên phải giảm.
   Trong `input.json` mới, `keepouts` không còn region định nghĩa board
   có khung phủ toàn PCB. Các vùng cấm thật vẫn còn.
5. Khi PreviewSmart chạy được, chạy `SmartRouteOnly` nếu chỉ muốn đi dây,
   hoặc `SmartAuto` để bố trí và đi dây. Kiểm tra DRC trên PCB kết quả.

Bạn có thể tự sửa riêng phần Pascal thay vì chép cả file `.pas`:
trong file hiện có, tìm `Function SP_PadJSON(`, thay toàn bộ hàm đó
bằng nội dung `SP_PadJSON_replacement.txt`.
Hàm kế tiếp là `Function SP_ComponentJSON(`; giữ nguyên hàm này
và toàn bộ phần còn lại. Sau đó thay toàn bộ `Procedure SP_Export(`
bằng nội dung `SP_Export_replacement.txt` để xử lý đúng Board Region.
Hàm kế tiếp sau SP_Export là `Function SP_Double`; giữ nguyên phần đó.
Vẫn phải dùng `router.js` mới để nhận `roundrect`.

## Các thay đổi trong gói

- `SmartPCB_AD2016.pas`: thay `SP_PadJSON` và `SP_Export` trong đúng bản bạn gửi.
  Kích thước đồng lấy từ các API size/shape trên lớp; khung bao chung chỉ
  còn kiểm tra tâm/offset. Thêm shape `roundrect` và `cornerRadius`.
  Giới hạn ở pad Simple Mode; giữ bảo vệ cho pad stack phức tạp,
  lỗ/offset không hỗ trợ. Tất cả 780 pad trong PCB đã kiểm tra đều ở Simple Mode.
  Loại Board Region định nghĩa board khỏi dữ liệu vật cản bằng
  `ViewableObjectID`; phân biệt loại region và giữ vùng cấm/board cutout thật.
- `router.js`: mô hình pad bo góc bằng hình chữ nhật lõi cộng bán kính,
  dùng cùng mô hình để tìm đường, kiểm tra clearance và xác định kết nối.
  Trường hợp bo góc tối đa trở thành oval hoặc hình tròn.
- `smartpcb.js`: hiển thị đúng độ bo góc trong hình xem trước;
  kiểm tra bán kính bo góc không đổi khi tạo phương án bố trí.

Gói này không thay độ rộng dây trong Rules và không bỏ bảo vệ toàn bộ net.
Pad/lỗ đặc biệt thật sự chưa hỗ trợ vẫn có thể cần xử lý thủ công.

## Phạm vi kiểm chứng

Đã phân tích dữ liệu pad trong chính PCB được lưu ở thư mục runtime.
Các bài kiểm tra JavaScript và mô phỏng đọc dữ liệu PCB được ghi ở
`KIEM_CHUNG.md`. Phần Pascal cần chạy PreviewSmart trong Altium 16.1
để xác nhận API trên máy của bạn; chưa có kiểm thử chạy native Altium
cho bản sửa này.

Bản sửa hướng đến PCB đã kiểm tra: trong dữ liệu nhị phân có đúng một
Board Region định nghĩa layer stack, không có Board Region riêng làm lỗ cắt.
Các board cutout dạng Region và cavity vẫn được xử lý như vật cản.

Nguồn đối chiếu API:
[Altium PCB API — Pad/Pad2](https://www.altium.com/documentation/altium-dxp-developer/pcb-api-design-objects-interfaces-reference).
Định dạng dữ liệu nhị phân PCB được đối chiếu với
[mã nguồn bộ đọc Altium của KiCad](https://github.com/KiCad/kicad-source-mirror/blob/master/pcbnew/pcb_io/altium/altium_parser_pcb.cpp).
