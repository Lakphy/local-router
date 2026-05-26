// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LocalRouter",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "LocalRouterLib",
            targets: ["LocalRouterLib"]
        )
    ],
    targets: [
        .target(
            name: "LocalRouterLib",
            path: "LocalRouter",
            exclude: ["Assets.xcassets", "LocalRouter.entitlements"],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "LocalRouterTests",
            dependencies: ["LocalRouterLib"],
            path: "LocalRouterTests"
        )
    ]
)
