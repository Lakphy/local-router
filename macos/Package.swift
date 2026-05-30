// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LocalRouter",
    platforms: [
        .macOS(.v15)
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
                .swiftLanguageMode(.v5),
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
