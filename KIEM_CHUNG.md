# Kiểm chứng bản sửa pad và Board Region

## Dữ liệu đã đọc

- Archive gốc: `D:\down\SmartPCB_AD2016_v3.rar`.
- Lần chạy thực tế: `D:\down\SmartPCB_AD2016_v3\SmartPCB_AD2016\runtime\20261008_161111`.
- Đã đọc `input.json`, `result.json` và PCB nhị phân lưu cùng thư mục.
- PCB có 167 linh kiện, 192 net và 780 pad.
- Tất cả pad ở Simple Mode; góc xoay là bội số 90 độ; không thấy offset pad
  trong bản ghi nhị phân. Có 220 pad bo góc, corner radius percentage 20%.
- Vùng cấm lớn phủ toàn PCB xuất phát từ stream BoardRegions, tên
  `Layer Stack Region 1`, có LayerStackID và không gán net.

## Kiểm tra JavaScript

Đã chạy bộ kiểm tra trên đúng mã sửa, Node.js v24:

- 12 kiểm tra bố trí.
- 20 kiểm tra đi dây hiện có.
- 8 kiểm tra hình học pad bo góc mới: khe ở góc, clearance, kết nối,
  khung vật cản, xoay, bán kính bằng 0/tối đa và giá trị sai.
- 14 kiểm tra tích hợp và dữ liệu import.

Tổng cộng **54 kiểm tra đạt**. Kiểm tra hình học bo góc dùng hình chữ nhật
lõi cộng đĩa tròn; không thay pad thật bằng hình chữ nhật đặc.

## Mô phỏng dữ liệu PCB thực tế

Dựng lại hình học đồng từ bản ghi pad trong chính PCB, giữ các vị trí linh kiện,
các vùng cấm còn lại và các pad khoan chưa được nhận dạng đầy đủ.
Đây là fixture kiểm chứng, không phải file import gửi vào Altium.

- Khi chỉ sửa hình học pad nhưng giữ vật cản Board Region sai:
  0 đoạn dây, 0 lần mở rộng tìm đường.
- Khi loại duy nhất Board Region định nghĩa layer stack ra khỏi vật cản:
  **126 đoạn dây**, **82/533 nhóm kết nối được nối**, 0 via.
- Giới hạn dùng trong mô phỏng: 1 lượt, tối đa 2.000 lần mở rộng mỗi tìm kiếm,
  tổng cộng 20.000 lần mở rộng. Vì giới hạn nhỏ và còn pad/net cần xử lý riêng,
  đây không phải kết quả hoàn tất PCB.
- Phương án có dây đi qua bộ kiểm tra hình học và kiểm tra dữ liệu native plan
  của engine. Vẫn cần chạy Altium DRC trên kết quả thật.

## Phần chưa kiểm chứng trực tiếp

Chưa chạy hoặc compile mã Pascal sửa trong Altium Designer 16.1.
Tên API/enum đã đối chiếu tài liệu và đăng ký trong ScriptingSystem.dll,
gồm GetState_CornerRadiusOnLayer, ViewableObjectID,
eViewableObject_BoardRegion và Region.Kind.
PreviewSmart trên máy người dùng là bước xác nhận runtime native.

Các file gốc trong `D:\down` và archive gốc không bị sửa.
File `.pas` thay thế dựa trên đúng bản trong archive người dùng gửi;
chỉ thay hai phần `SP_PadJSON` và `SP_Export`.
