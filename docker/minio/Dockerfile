# MinIO stopped publishing official Docker images (minio/minio is gone from Docker Hub), so the
# local S3 server is built from the pinned source tag. Production uses AWS S3, not this.
FROM golang:1.25-alpine AS build
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
RUN apk add --no-cache git
RUN git clone --depth 1 --branch ${MINIO_TAG} https://github.com/minio/minio /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/minio .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /usr/local/bin/minio
EXPOSE 9000 9001
VOLUME /data
ENTRYPOINT ["minio"]
