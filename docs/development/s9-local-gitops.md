# Kubernetes/GitOps local — S9

S9 dùng kind, Calico, Helm và Argo CD. Xem [kế hoạch và điều kiện nghiệm
thu](../../plans/s9-local-gitops.md) trước khi thay đổi topology. Cần Docker
Linux engine với tối thiểu 4 CPU/8 GiB RAM, kubectl 1.33–1.35, Git, tar,
Node và pnpm đúng phiên bản trong `.node-version`/`package.json`. Windows
cần Docker Desktop chạy Linux containers. Chỉ hỗ trợ amd64 cho profile này.

## Thiết lập từ checkout mới

Chạy tại thư mục gốc repository, với Node/pnpm đã ghim trong PATH:

```powershell
pnpm install --frozen-lockfile
pnpm s9 tools
pnpm s9 preflight
pnpm test:s9
pnpm s9 cluster
```

`tools` tải kind/Helm từ upstream vào `.cache/s9/tools`, kiểm tra SHA-256
đã ghim; không cài global hoặc sửa PATH. `cluster` dùng node image theo
digest, cài manifest Calico/Argo đã kiểm tra hash. Kubeconfig nằm riêng
ở `.cache/s9/kubeconfig`; lệnh luôn chọn context `kind-loremaster-s9`.
Cluster trùng tên nhưng khác container ID bị từ chối. Dùng `cluster` để
tiếp tục bootstrap đã gián đoạn khi marker còn khớp.

Sau đó build và scan các image S8 từ chính checkout này. Nếu chưa có
builder S8, tạo builder với BuildKit đã ghim như workflow CI hiện có:

```powershell
docker buildx create --name loremaster-s9-build --driver docker-container --driver-opt image=moby/buildkit:v0.25.1@sha256:79cc6476ab1a3371c9afd8b44e7c55610057c43e18d9b39b68e2b0c2475cc1b6 --use
pnpm test:images
pnpm s9 promote
pnpm s9 render
pnpm s9 bootstrap
pnpm s9 sync
pnpm s9 status
pnpm test:s9:runtime
```

Chỉ chạy lệnh tạo builder một lần; dùng `docker buildx use
loremaster-s9-build` nếu builder đã có. Scan quá 24 giờ, sai source/context,
sai config ID, secret finding hoặc vulnerability chưa được chấp thuận đều
chặn promote. Registry chỉ publish `127.0.0.1:5001`; image được kéo lại theo
manifest digest và đối chiếu với config ID đã scan. `render` không thay thế
runtime gate.

`bootstrap` tạo secret ngẫu nhiên riêng theo role, bật hai data service,
chạy migration Job một lần và cấp role PostgreSQL. Không tự import nội dung.
Giữ `.cache/s9/secrets.json` cùng môi trường này; mất secret trong khi PVC
còn tồn tại sẽ chặn tái tạo credential. Không commit `.cache/`, không gửi
credential trong log hoặc artifact. Sau khi Argo nhận quyền quản lý app,
không chạy lại bootstrap; dùng `pnpm s9 migration` cho migration tương thích.

`sync` tạo commit trong Git repository riêng ở `.cache/s9/git`, chứa chart
và image values đã admit. Argo đọc Git daemon chỉ có quyền đọc trên mạng
Docker kind. AppProject giới hạn namespace/kind, bật self-heal và prune.
Không cần push mã nguồn lên GitHub để chạy lab local. Sau mỗi thay đổi
chart hoặc image đã admit, chạy `sync` để cập nhật desired state; sửa file
trong checkout chưa tự trở thành commit trong Git remote local.

## Nội dung và truy cập

Import cần content pack đã được review theo [content policy](../content-policy.md).
File private được đặt trong Secret tạm, mount từng file, xóa sau Job:

```powershell
$env:LOREMASTER_S9_CONTENT_FILE = 'C:/private/reviewed-pack.json'
pnpm s9 import
pnpm s9 import --publish
pnpm s9 forward
```

`import` mặc định dry-run; `--publish` là thao tác xuất bản vào database
local. Mở [game local](http://localhost:8080) khi port-forward đang chạy.
Chưa import sẽ không có case để chơi. API, worker, observer, PostgreSQL và
Redis không publish host port. API giữ chế độ local/cookie local và chỉ
tin gateway `10.244.240.10/32`. Web có một replica với fixed IP, rollout
`Recreate` nên có khoảng gián đoạn; đây là profile học vận hành local.

Argo server là ClusterIP. Để xem UI, chạy ở terminal riêng:

```powershell
kubectl --kubeconfig .cache/s9/kubeconfig --context kind-loremaster-s9 -n argocd port-forward --address=127.0.0.1 service/argocd-server 8443:443
```

Lấy credential quản trị ban đầu bằng quy trình Argo chính thức; không đưa
password vào hồ sơ nghiệm thu. Không mở service này ra LAN/Internet.

## Kiểm chứng, sửa drift và rollback

`test:s9` lint/render Helm bằng digest giả để kiểm tra cấu trúc, probe,
UID, mount secret và network matrix. `test:s9:runtime` chỉ chạy sau khi
cluster/secret/migration/sync hoàn tất. Gate thực tế kiểm tra bốn node,
desired Git revision `Synced/Healthy`, đường mạng được phép và bị từ chối,
FD, giới hạn Redis 64 PID tại OCI spec và cgroup kernel (v1/v2), quyền secret, replica drift, thay pod dữ liệu giữ PVC và schema,
cache marker Redis còn nguyên sau restart, thay desired replica qua Git rồi
rollback về hai API replicas, HTML và guest session qua gateway thật.

Gate recovery xóa pod PostgreSQL/Redis và gate rollback đổi replica,
nên chỉ chạy trên lab S9 riêng này. Gate không xóa PVC. Dữ liệu node-local
không tự phục hồi khi mất node; cần backup/restore cho yêu cầu đó. Redis
recovery chưa phải bằng chứng gameplay sau mất cache; các gate S8 tương ứng vẫn được giữ.

Chạy `pnpm test:s9:drain` để kiểm tra shutdown qua xóa pod và SIGTERM của
kubelet. Gate tạo namespace riêng, credential mới và một fixture tổng hợp;
chặn truy vấn đọc entity của warm job thật trước khi xóa worker, rồi kiểm
tra replay hoàn tất đúng một lần và không ghi tám bảng gameplay. API phải
đóng request HTTP đã nhận nhưng chưa nhận đủ body. Worker/API có budget
20 giây; observer/web có budget 15 giây. Gate đọc exit code và thời gian
thoát từ CRI, dọn namespace/PVC/PV thử và ghi `.cache/s9/drain.json`.
Web trong namespace thử dùng IP động cho kiểm tra idle shutdown; bài
runtime chính kiểm tra gateway fixed IP và proxy trust.

RuntimeClass `loremaster` giữ ceiling 128 PID và 1.024 FD; runtime
`loremaster-redis` đặt 64 PID riêng cho Redis. Admission từ chối Redis
dùng handler thông thường và từ chối image khác dùng handler Redis.
Kubelet vẫn đặt `podPidsLimit: 128` trên cả bốn node.

Workflow `S9 local runtime` chạy cho PR, push vào main và thủ công. Nó
dựng/scanning image, tạo lab sạch, chạy cả hai gate runtime/drain, lưu
evidence không chứa secret và luôn dọn đúng lab do job tạo. Workflow CI
chính giữ các gate S8, browser và T25, đồng thời kiểm tra policy S9.

Để rollback release, giữ digest trước đó trong registry, khôi phục chart
và image values đã admit rồi chạy `sync`. Không dùng `kubectl rollout undo`
làm desired state lâu dài vì Argo sẽ sửa lại drift. Không rollback schema
phá hủy dữ liệu; dùng image tương thích và migration sửa tiếp.

Secret dùng `subPath` để tránh symlink. Sau khi đổi secret đúng quy trình,
cần restart pod để nhận file mới. Không đổi các password của PostgreSQL
bằng cách ghi đè file local; bootstrap từ chối credential không khớp.

## Dọn lab

`Ctrl+C` dừng port-forward. Cluster, registry và Git server local tiếp tục
chạy. Chỉ khi chủ động muốn xóa lab và dữ liệu:

```powershell
pnpm s9 destroy --delete-data
```

Lệnh kiểm tra container ID/ownership, xóa đúng cluster S9 và hai container
phụ trợ, rồi xác nhận không còn container có nhãn sở hữu S9. Lệnh giữ
evidence trong `.cache/s9/`; không prune Docker toàn cục và không đụng
stack Compose S8. Xóa kind sẽ mất PostgreSQL/Redis trong local PV. Không
chạy destroy trên lab đang cần giữ dữ liệu.

Lưu snapshot không chứa secret sau khi gate runtime và Argo đều đã PASS:

```powershell
node scripts/s9-evidence.mjs --write-durable
```

Lệnh chỉ lấy các trường đã cho phép từ evidence, trạng thái node/Argo và
digest image; không sao chép kubeconfig, secret JSON hay nội dung Git remote.

Nguồn tham chiếu: [kind local registry](https://kind.sigs.k8s.io/docs/user/local-registry/),
[Calico static pod IP](https://docs.tigera.io/calico/latest/networking/ipam/use-specific-ip),
[Argo declarative setup](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/),
[containerd base runtime spec](https://containerd.io/docs/2.1/cri/config/).
