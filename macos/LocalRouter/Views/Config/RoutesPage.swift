import SwiftUI

struct RoutesPage: View {
    var body: some View {
        ScrollView {
            RoutesEditorView()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(DS.padPage)
        }
        .contentScroll()
    }
}
